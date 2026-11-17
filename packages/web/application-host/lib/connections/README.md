# Host connections

The Application Host owns saved connections, SSH processes, forwards, status,
reconnect intent and remote bootstrap. `ssh-manager.ts` is the former Electron
implementation moved to this owner; the shell forwards its native client commands
to the embedded Host. Web/mobile clients use authenticated `/api/connections`
routes and the shared event stream. Connection administration is Host-wide:
configuration reads include credentials and require instance/config read and
write capabilities. SSH configuration and connect/disconnect also require
terminal/process control. Read-only and directory-scoped clients cannot use
these management routes; this does not prevent capability-filtered source
discovery elsewhere. SSH agent, keys and askpass run only on the
owning Host. Switching clients never copies credentials between Hosts.

`hosts.ts` is the common settings adapter. Electron also uses its read path before
startup to select the initial UI connection; it has no duplicate connection store.
`hostSshConnections` records desired connections, which the Host restores without
a renderer. Explicit disconnect clears that intent; Host shutdown keeps it for
the next startup and drains in-flight connection attempts.

`host-proxy.ts` exposes a saved HTTP/SSH connection under
`/api/connections/hosts/:id/proxy`. Browser runtime HTTP, SSE and WebSocket URLs
retain that prefix. The gateway authenticates the local client and requires the full Host-wide
control capability set (including the existing admin/wildcard semantics), then
substitutes the
saved peer credential. It removes local cookies and URL tokens, and keeps URL-token
minting at the gateway's existing auth owner. Neither a request parameter nor a
browser-provided URL selects the upstream. Desktop can still connect directly to
its own loopback forward.

The native SSH tests now run with the Host suite. The gateway test opens real
HTTP and WebSocket servers and covers body forwarding, authentication and owner
credential separation. It does not prove connectivity to a real SSH server or a
graphical desktop. Linux desktop provisioning is a separate capability using
these connections, not implied by an SSH `ready` status.

HTTP/SSE and WebSocket authorization use the same authenticated principal;
short-lived URL grants retain their issuing session or revalidate the issuing
client's current bearer permissions. The inner URL must still pass the existing
read/realtime allowlist. A connection proxy is not a way for a restricted client
to inherit a saved peer's broader authority.

`deployment-ssh.ts` is the Host-only deployment transport. It reuses saved SSH
parsing, authentication and subprocess ownership without calling the work
connection's `connect()` or starting a remote Varin. A dedicated private
ControlMaster uses strict existing OpenSSH known-host verification, disables
host-key updates, TTY allocation and forwards, and pins commands to that exact
connection. Missing multiplex sockets cannot fall back to a new target connection.
Unknown or changed keys, ambiguous target fingerprints and edited saved targets
pause the attempt; this module never accepts or repairs a known-host record.
Windows Hosts fail closed until there is an equivalent pinned transport.

Read-only inspection runs a fixed Python 3 probe for Linux/systemd, prerequisites,
requested paths, listeners and units. `inventoryComplete` covers only those
requested observations, not DNS, firewall, certificate trust or shared proxy
compatibility. Parent-path trust is explicit. An ownership marker is returned
only from a private root-owned regular file with trusted non-symlink ancestors;
the deployment owner must still validate its schema, target, digest and resource
ownership. A marker name alone is not evidence.

Session handles and reviewed-action capabilities are in-process identities, not
serializable HTTP authority. Only a trusted provisioner may register generated
scripts after reviewing its plan. Scripts and payloads travel on stdin, never in
argv; raw subprocess errors are not exposed as status or logs. Action capabilities
are single-use, and unknown effects pause the session. The deployment lifecycle
owner remains responsible for durable remote operation records, locking,
reconciliation and stop proof; killing an SSH client does not prove that a remote
operation stopped. Tests use fake SSH children, a local read-only probe and
`ssh -G` (configuration resolution only), not a deployed SSH server.
