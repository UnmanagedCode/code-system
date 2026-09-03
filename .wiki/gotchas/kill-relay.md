# The provider must relay the kill

**What:** cc's protocol MUST 3 requires a provider to exit on stdin EOF and take everything it started down with it. A `docker exec` child is reparented inside the container's namespace, and an `ssh` slave connection similarly outlives its parent — neither dies on its own when the provider process exits.

**Why:** Without explicit action, stdin-EOF only kills the provider process itself; the `docker exec` child and any orphaned `ssh` control-master/slave connections keep running, leaking processes inside the container/on the remote host and violating MUST 3.

**How to apply:** The provider's shutdown path must explicitly SIGKILL every child it started (`docker exec` children, `ssh` slaves) before or as part of exiting on stdin EOF. This is not optional cleanup — it's a protocol MUST.
