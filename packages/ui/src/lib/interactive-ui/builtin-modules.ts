/** Published with the application, resolved through the existing work-file module
 * loader. No network request or privileged host API is added by this helper. */
export const UI_CONTROLS_MODULE = `
const css = ":where(.varin-controls){color:inherit;font:inherit}.varin-controls :where(input,select,textarea,button){font:inherit;color:inherit;border:1px solid var(--border);border-radius:.45rem;padding:.5rem .7rem;max-width:100%;min-width:0;background:transparent}.varin-controls :where(input,textarea,select){background:var(--background);color:var(--foreground)}.varin-controls :where(input[type=checkbox],input[type=radio]){accent-color:var(--primary)}.varin-controls :where(button){cursor:pointer;transition:background-color .15s ease}.varin-controls button:hover{background:var(--muted);color:var(--muted-foreground)}.varin-controls :where(:focus-visible){outline:2px solid var(--primary);outline-offset:2px}.varin-controls :disabled{opacity:.5;cursor:default}.varin-field{display:flex;flex-direction:column;gap:.4rem;margin:.7rem 0}.varin-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}.varin-note{font-size:.875em;opacity:.75}.varin-error{color:var(--destructive,#b42318)}@media(prefers-reduced-motion:reduce){.varin-controls *{transition:none!important}}";
export function install(root=document.getElementById('work') || document.body){
  if(!document.getElementById('varin-controls-style')){const style=document.createElement('style');style.id='varin-controls-style';style.textContent=css;document.head.append(style)}
  root.classList.add('varin-controls');return root;
}
export function button(label, onClick){const node=document.createElement('button');node.type='button';node.textContent=label;if(onClick)node.addEventListener('click',onClick);return node}
export function field(label, input){const node=document.createElement('label');node.className='varin-field';const text=document.createElement('span');text.textContent=label;node.append(text,input);return node}
export function status(container, text, error=false){let node=container.querySelector('[data-varin-status]');if(!node){node=document.createElement('p');node.dataset.varinStatus='';container.append(node)}node.setAttribute('role',error?'alert':'status');node.className=error?'varin-error':'varin-note';node.textContent=text;return node}
export const controls=Object.freeze({install,button,field,status});
`;
