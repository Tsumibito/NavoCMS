# Supported pilot hosting profile

See [the installation and recovery runbook](../../docs/operations/SELF_HOSTING.md).
The runtime and operations containers are separate. The runtime never receives
the database owner connection or backup encryption key. HTTPS ingress is managed
by the operator through Coolify or an equivalent reverse proxy. Timer examples
assume `/opt/navocms` and `/var/backups/navocms`; adjust both the mount and service
paths together. Journal alerts are local; an external notification destination
must be configured and tested by the operator.
