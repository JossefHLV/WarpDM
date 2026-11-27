# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `3.5.x` (Latest) | ✅ Yes |
| `< 3.5.0` | ❌ Upgrade to latest release |

## Security Architecture Highlights

- **Localhost-Only Bridge**: The WarpDM engine listens strictly on `127.0.0.1:20888` (loopback interface only) and is never exposed to LAN or WAN interfaces.
- **Ephemeral Cookie Handling**: Authenticated media extraction writes temporary cookie files with `0600` owner-only permissions and deletes them immediately upon probe/transfer completion.
- **ZipSlip Path Traversal Guard**: Both the installer and remote ZIP inspector validate canonical paths before extracting entries.

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories on this repository rather than opening a public issue.
