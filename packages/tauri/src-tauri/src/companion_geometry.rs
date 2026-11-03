//! Global DIP coordinates are monitor-relative, not physical coordinates divided
//! by the current window's scale. Windows follows Chromium's connected-display
//! layout model (ui/display/win/{screen_win,scaling_util}.cc). Other platforms
//! already report monitor origins in their own scaled logical coordinate space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    fn right(self) -> f64 {
        self.x + self.width
    }
    fn bottom(self) -> f64 {
        self.y + self.height
    }
    fn distance(self, x: f64, y: f64) -> f64 {
        (self.x - x).max(x - self.right()).max(0.).powi(2)
            + (self.y - y).max(y - self.bottom()).max(0.).powi(2)
    }
    fn overlap(self, b: Self) -> f64 {
        (self.right().min(b.right()) - self.x.max(b.x)).max(0.)
            * (self.bottom().min(b.bottom()) - self.y.max(b.y)).max(0.)
    }
}
#[derive(Clone, Debug)]
pub struct Display {
    pub id: u64,
    pub physical: Rect,
    pub work: Rect,
    pub scale: f64,
    pub logical: Rect,
}
impl Display {
    pub fn new(id: u64, physical: Rect, work: Rect, scale: f64) -> Self {
        Self {
            id,
            physical,
            work,
            scale,
            logical: Rect {
                x: physical.x / scale,
                y: physical.y / scale,
                width: physical.width / scale,
                height: physical.height / scale,
            },
        }
    }
    pub fn to_logical(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.logical.x + (x - self.physical.x) / self.scale,
            self.logical.y + (y - self.physical.y) / self.scale,
        )
    }
    pub fn to_physical(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.physical.x + (x - self.logical.x) * self.scale,
            self.physical.y + (y - self.logical.y) * self.scale,
        )
    }
    pub fn work_area(&self) -> Rect {
        let (x, y) = self.to_logical(self.work.x, self.work.y);
        Rect {
            x,
            y,
            width: self.work.width / self.scale,
            height: self.work.height / self.scale,
        }
    }
}
// Preserve start/end alignment and partial-overlap anchors in the parent's DIP
// lane, including a larger child that straddles both ends of its parent.
fn lane_offset(
    start: f64,
    length: f64,
    child_start: f64,
    child_length: f64,
    parent_scale: f64,
    child_scale: f64,
) -> f64 {
    let begin = child_start - start;
    let end = begin + child_length;
    if end == length && begin != 0. {
        length / parent_scale - child_length / child_scale
    } else if begin >= 0. && begin <= length {
        (begin / parent_scale).floor()
    } else if end >= 0. && end <= length {
        length / parent_scale - child_length / child_scale - ((length - end) / parent_scale).floor()
    } else {
        (begin / child_scale).floor()
    }
}
pub fn layout(mut displays: Vec<Display>, primary: u64, connected_windows: bool) -> Vec<Display> {
    if !connected_windows {
        return displays;
    }
    let Some(root) = displays.iter().position(|m| m.id == primary) else {
        return displays;
    };
    let mut placed = vec![false; displays.len()];
    placed[root] = true;
    let mut stack = vec![root];
    while let Some(parent) = stack.pop() {
        for child in 0..displays.len() {
            if placed[child] {
                continue;
            }
            let a = &displays[parent];
            let b = &displays[child];
            let p = a.physical;
            let c = b.physical;
            let vertical =
                p.x.max(c.x) == p.right().min(c.right()) && p.y <= c.bottom() && c.y <= p.bottom();
            let horizontal =
                p.y.max(c.y) == p.bottom().min(c.bottom()) && p.x <= c.right() && c.x <= p.right();
            if !vertical && !horizontal {
                continue;
            }
            // Chromium resolves a corner towards bottom, left, then top.
            let side = if vertical && horizontal {
                if p.bottom() == p.y.max(c.y) {
                    2
                } else if p.x == p.x.max(c.x) {
                    3
                } else {
                    0
                }
            } else if vertical {
                if c.right() == p.x { 3 } else { 1 }
            } else if c.bottom() == p.y {
                0
            } else {
                2
            };
            let mut logical = b.logical;
            if side == 1 || side == 3 {
                logical.x = if side == 1 {
                    a.logical.right()
                } else {
                    a.logical.x - logical.width
                };
                logical.y =
                    a.logical.y + lane_offset(p.y, p.height, c.y, c.height, a.scale, b.scale);
            } else {
                logical.y = if side == 2 {
                    a.logical.bottom()
                } else {
                    a.logical.y - logical.height
                };
                logical.x = a.logical.x + lane_offset(p.x, p.width, c.x, c.width, a.scale, b.scale);
            }
            displays[child].logical = logical;
            placed[child] = true;
            stack.push(child);
        }
    }
    displays
}
pub fn nearest(displays: &[Display], rect: Rect, physical: bool) -> Option<&Display> {
    displays.iter().min_by(|a, b| {
        let ra = if physical { a.physical } else { a.logical };
        let rb = if physical { b.physical } else { b.logical };
        let score = |r: Rect| {
            let overlap = r.overlap(rect);
            if overlap > 0. {
                -overlap
            } else {
                r.distance(rect.x + rect.width / 2., rect.y + rect.height / 2.)
            }
        };
        score(ra).total_cmp(&score(rb))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect {
            x,
            y,
            width: w,
            height: h,
        }
    }
    #[test]
    fn mixed_dpi_adjacent_displays_keep_shared_edges_and_roundtrip() {
        let ds = layout(
            vec![
                Display::new(
                    1,
                    rect(0., 0., 3840., 2160.),
                    rect(0., 0., 3840., 2080.),
                    2.,
                ),
                Display::new(
                    2,
                    rect(3840., 0., 1920., 1080.),
                    rect(3840., 0., 1920., 1040.),
                    1.,
                ),
            ],
            1,
            true,
        );
        assert_eq!(ds[0].logical.right(), ds[1].logical.x);
        assert_eq!(ds[1].logical.x, 1920.);
        assert_eq!(ds[0].work_area().height, 1040.);
        assert_eq!(ds[1].to_logical(4000., 100.), (2080., 100.));
        assert_eq!(ds[1].to_physical(2080., 100.), (4000., 100.));
        assert_eq!(
            nearest(&ds, rect(2080., 100., 360., 480.), false)
                .unwrap()
                .id,
            2
        );
    }
    #[test]
    fn negative_and_end_aligned_monitors_keep_bottom_anchor() {
        let ds = layout(
            vec![
                Display::new(
                    1,
                    rect(0., 0., 3840., 2160.),
                    rect(0., 0., 3840., 2160.),
                    2.,
                ),
                Display::new(
                    2,
                    rect(-1920., 1080., 1920., 1080.),
                    rect(-1920., 1080., 1920., 1080.),
                    1.,
                ),
            ],
            1,
            true,
        );
        assert_eq!(ds[1].logical, rect(-1920., 0., 1920., 1080.));
        assert_eq!(ds[1].to_logical(-100., 1100.), (-100., 20.));
    }
    #[test]
    fn disconnected_layout_and_mac_origins_do_not_use_another_displays_scale() {
        let ds = layout(
            vec![
                Display::new(
                    1,
                    rect(0., 0., 3840., 2160.),
                    rect(0., 0., 3840., 2160.),
                    2.,
                ),
                Display::new(
                    2,
                    rect(1920., 0., 1920., 1080.),
                    rect(1920., 0., 1920., 1080.),
                    1.,
                ),
            ],
            1,
            false,
        );
        assert_eq!(ds[1].logical.x, 1920.);
    }
}
