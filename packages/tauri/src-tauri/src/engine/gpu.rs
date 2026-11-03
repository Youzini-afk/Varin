//! Native alpha composition of live CEF paint buffers. No screenshot polling,
//! frame-rate cap, opaque fallback, or disabled Chromium GPU is used.
use std::{
    cell::RefCell,
    sync::{Arc, Weak},
};
use winit::window::Window;
#[cfg(target_os = "macos")]
use winit::raw_window_handle::HasDisplayHandle;

struct Context {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
}
thread_local! { static CONTEXT: RefCell<Weak<Context>> = RefCell::default(); }

pub enum PresentOutcome {
    Presented,
    Retry,
    Occluded,
}

pub struct Surface {
    // Drop the native surface before the last context and native window handles.
    surface: wgpu::Surface<'static>,
    #[cfg(target_os = "macos")]
    _metal_host: super::macos_chrome::MetalHost,
    context: Arc<Context>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    texture: wgpu::Texture,
    binding: wgpu::BindGroup,
}

impl Surface {
    pub fn new(window: Arc<dyn Window>) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        let metal_host = super::macos_chrome::MetalHost::new(window.clone())?;
        let create_surface = |instance: &wgpu::Instance| -> Result<wgpu::Surface<'static>, String> {
            #[cfg(target_os = "macos")]
            {
                // SAFETY: the surface drops before the retained MetalHost view
                // and its original native window. Neither handle is replaced.
                unsafe {
                    instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                        raw_display_handle: Some(
                            window
                                .display_handle()
                                .map_err(|e| e.to_string())?
                                .as_raw(),
                        ),
                        raw_window_handle: metal_host.raw_handle(),
                    })
                }
                .map_err(|e| e.to_string())
            }
            #[cfg(not(target_os = "macos"))]
            {
                instance
                    .create_surface(window.clone())
                    .map_err(|e| e.to_string())
            }
        };
        let previous = CONTEXT.with(|context| context.borrow().upgrade());
        let (context, surface) = if let Some(context) = previous {
            let surface = create_surface(&context.instance)?;
            (context, surface)
        } else {
            let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
            // A HWND swapchain ignores alpha. DirectComposition is required.
            #[cfg(windows)]
            {
                descriptor.backends = wgpu::Backends::DX12;
                descriptor.backend_options.dx12.presentation_system =
                    wgpu::Dx12SwapchainKind::DxgiFromVisual;
            }
            #[cfg(target_os = "macos")]
            {
                descriptor.backends = wgpu::Backends::METAL;
            }
            #[cfg(target_os = "linux")]
            {
                descriptor.backends = wgpu::Backends::VULKAN;
            }
            let instance = wgpu::Instance::new(descriptor);
            let surface = create_surface(&instance)?;
            let adapter =
                pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                    compatible_surface: Some(&surface),
                    power_preference: wgpu::PowerPreference::LowPower,
                    force_fallback_adapter: false,
                    ..Default::default()
                }))
                .map_err(|e| e.to_string())?;
            let (device, queue) =
                pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                    label: Some("Varin transparent compositor"),
                    ..Default::default()
                }))
                .map_err(|e| e.to_string())?;
            let context = Arc::new(Context {
                instance,
                adapter,
                device,
                queue,
            });
            CONTEXT.with(|slot| *slot.borrow_mut() = Arc::downgrade(&context));
            (context, surface)
        };
        let caps = surface.get_capabilities(&context.adapter);
        let alpha_mode = [
            wgpu::CompositeAlphaMode::PreMultiplied,
            wgpu::CompositeAlphaMode::PostMultiplied,
        ]
        .into_iter()
        .find(|mode| caps.alpha_modes.contains(mode))
        .ok_or("The native compositor does not support transparent surfaces")?;
        let size = window.surface_size();
        let mut config = surface
            .get_default_config(&context.adapter, size.width.max(1), size.height.max(1))
            .ok_or("The native GPU does not support this window surface")?;
        config.alpha_mode = alpha_mode;
        config.present_mode = wgpu::PresentMode::AutoVsync;
        if let Some(format) = caps.formats.iter().find(|format| !format.is_srgb()) {
            config.format = *format;
        }
        surface.configure(&context.device, &config);
        let fragment = format!(
            "{}\n{}\nreturn c;",
            if alpha_mode == wgpu::CompositeAlphaMode::PostMultiplied {
                "if (c.a > 0.0) { c = vec4(c.rgb / c.a, c.a); }"
            } else {
                ""
            },
            if config.format.is_srgb() {
                "c = vec4(select(c.rgb / 12.92, pow((c.rgb + vec3(0.055)) / 1.055, vec3(2.4)), c.rgb > vec3(0.04045)), c.a);"
            } else {
                ""
            }
        );
        let shader = context
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("CEF premultiplied BGRA"),
                source: wgpu::ShaderSource::Wgsl(
                    format!(
                        r#"
@group(0) @binding(0) var page: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {{
    let p = array(vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
    return vec4(p[i],0.0,1.0);
}}
@fragment fn fragment(@builtin(position) p:vec4<f32>) -> @location(0) vec4<f32> {{
    var c = textureLoad(page, vec2<i32>(p.xy), 0);
    {fragment}
}}
"#
                    )
                    .into(),
                ),
            });
        let pipeline = context
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("CEF native composition"),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: config.format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
        let (texture, binding) =
            Self::texture(&context.device, &pipeline, config.width, config.height);
        Ok(Self {
            surface,
            #[cfg(target_os = "macos")]
            _metal_host: metal_host,
            context,
            config,
            pipeline,
            texture,
            binding,
        })
    }
    fn texture(
        device: &wgpu::Device,
        pipeline: &wgpu::RenderPipeline,
        width: u32,
        height: u32,
    ) -> (wgpu::Texture, wgpu::BindGroup) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("CEF live frame"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("CEF frame binding"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(
                    &texture.create_view(&Default::default()),
                ),
            }],
        });
        (texture, binding)
    }
    pub fn observation(&self) -> serde_json::Value {
        let info = self.context.adapter.get_info();
        serde_json::json!({"backend":format!("{:?}",info.backend),"adapter":info.name,
            "alphaMode":format!("{:?}",self.config.alpha_mode),"width":self.config.width,"height":self.config.height})
    }
    pub fn present(
        &mut self,
        width: u32,
        height: u32,
        bgra: &[u8],
    ) -> Result<PresentOutcome, String> {
        if width == 0 || height == 0 {
            return Ok(PresentOutcome::Occluded);
        }
        if bgra.len() != width as usize * height as usize * 4 {
            return Err("Invalid native frame size".into());
        }
        if (width, height) != (self.config.width, self.config.height) {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.context.device, &self.config);
            (self.texture, self.binding) =
                Self::texture(&self.context.device, &self.pipeline, width, height);
        }
        self.context.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            bgra,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.context.device, &self.config);
                return Ok(PresentOutcome::Retry);
            }
            wgpu::CurrentSurfaceTexture::Timeout => return Ok(PresentOutcome::Retry),
            wgpu::CurrentSurfaceTexture::Occluded => return Ok(PresentOutcome::Occluded),
            wgpu::CurrentSurfaceTexture::Lost => {
                return Err("The native compositor surface was lost".into());
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err("Native compositor surface validation failed".into());
            }
        };
        let target = frame.texture.create_view(&Default::default());
        let mut encoder = self
            .context
            .device
            .create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("CEF transparent presentation"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.binding, &[]);
            pass.draw(0..3, 0..1);
        }
        self.context.queue.submit([encoder.finish()]);
        self.context.queue.present(frame);
        Ok(PresentOutcome::Presented)
    }
}
