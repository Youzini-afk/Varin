# Host connections

The Application Host owns saved connections, SSH processes, forwards, status,
reconnect intent and remote bootstrap. `ssh-manager.ts` is the former Electron
implementation moved to this owner; the shell forwards its native client commands
to the embedded Host. Web/mobile clients use authenticated `/api/connections`
routes and the shared event stream. SSH agent, keys and askpass run only on the
owning Host. Switching clients never copies credentials between Hosts.

`hosts.ts` is the common settings adapter. Electron also uses its read path before
startup to select the initial UI connection; it has no duplicate connection store.
`hostSshConnections` records desired connections, which the Host restores without
a renderer. Explicit disconnect clears that intent; Host shutdown keeps it for
the next startup and drains in-flight connection attempts.

`host-proxy.ts` exposes a saved HTTP/SSH connection under
`/api/connections/hosts/:id/proxy`. Browser runtime HTTP, SSE and WebSocket URLs
retain that prefix. The gateway authenticates the local client, substitutes the
saved peer credential, removes local cookies and URL tokens, and keeps URL-token
minting at the gateway's existing auth owner. Neither a request parameter nor a
browser-provided URL selects the upstream. Desktop can still connect directly to
its own loopback forward.

The native SSH tests now run with the Host suite. The gateway test opens real
HTTP and WebSocket servers and covers body forwarding, authentication and owner
credential separation. It does not prove connectivity to a real SSH server or a
graphical desktop. Linux desktop provisioning is a separate capability using
these connections, not implied by an SSH `ready` status.
