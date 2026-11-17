/** cmd.exe reads a command script twice: its /c command line, then the batch
 * invocation. Keep argv as data across both parses (including % and quotes). */
export function windowsCommandScript(command: string, args: readonly string[]) {
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const escape = (value: string) => value.replace(meta, "^$1");
  const argument = (value: string) => {
    const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
    return escape(escape(quoted));
  };
  return `/d /s /c "${escape(command)}${args.length ? ` ${args.map(argument).join(" ")}` : ""}"`;
}
