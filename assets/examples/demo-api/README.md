# Demo customer API

Intentionally vulnerable source for reproducible Zero UI demonstrations.
Do not deploy or run it. Review source only; do not send requests or execute payloads.

The API handles customer email and billing addresses for a multi-tenant service.
An upstream gateway authenticates signed-in users, but these routes must enforce
customer ownership and role permissions. The database uses PostgreSQL. The export
route runs in a service container with access to application files.
