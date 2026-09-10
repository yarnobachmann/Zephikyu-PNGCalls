# Security notes

## Scope

Zephikyu PNGCalls is designed for one host account and guests who enter through private room links. It stores room configuration, player display names, speaking presence, image paths, optional Discord identity, audit events, and password hashes. Microphone audio is processed in the guest browser and is not recorded or sent to the server. Webcam mode sends replaceable JPEG frames to the self-hosted server and does not create a video recording.

## Implemented controls

- Host passwords use Node.js scrypt with a unique random salt.
- Host sessions are random server-side records with 12-hour expiry.
- Host cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` when HTTPS is detected.
- Guest capability keys are kept in `HttpOnly` cookies rather than browser storage.
- State-changing host requests require a session-bound CSRF token.
- Authorization is enforced on every host, guest, room, and overlay route.
- Login, guest join, upload, and heartbeat endpoints are rate limited.
- Security headers include a Content Security Policy, frame restrictions, MIME sniffing protection, and referrer restrictions.
- Request bodies and uploads have size limits.
- Images use allowlisted formats, randomized server filenames, MIME checks, and file-signature checks.
- Prisma parameterizes database access to the local SQLite database.
- Authentication, room changes, guest joins, and server errors create audit events. IP addresses are stored only as short-lived keyed hashes.
- Unexpected errors return a generic message without stack traces or internal paths.

## Production responsibilities

1. Terminate HTTPS at a maintained reverse proxy and restrict direct access to port 4173.
2. Run the container or Node process with a dedicated low-privilege service account.
3. Restrict read access to `data`, `uploads`, environment configuration, and backups.
4. Back up `data` and `uploads` together. Encrypt backups, define retention, and test restoration.
5. Monitor authentication failures, application errors, disk use, and availability.
6. Apply operating system, Node.js, container, and dependency security updates on a defined schedule.
7. Document access reviews, incident response, supplier risks, asset ownership, and change approvals.
8. Rotate a disclosed room link by deleting the affected room and creating a replacement.
9. Keep the Proxmox host, Debian LXC, Docker Engine, Caddy image, and application image on a documented patch schedule.
10. Limit inbound network access to TCP 80 and 443 plus UDP 443 for HTTP/3. Do not publish the application port directly in production.

## Standards statement

The application applies relevant OWASP ASVS and Cheat Sheet guidance. It has not received an independent ASVS assessment.

The controls can support an ISO/IEC 27001:2022 information security management system. ISO certification applies to an organization's complete ISMS, including people, processes, risk treatment, evidence, internal audits, and independent certification. This repository by itself is not ISO/IEC 27001 certified.

## Reporting

Do not disclose a suspected vulnerability in a public issue. Send it privately to the deployment owner with the affected version, impact, reproduction steps, and any relevant logs with secrets removed.
