Vibe Halo is derived from Clawd on Desk:
https://github.com/rullerzhou-afk/clawd-on-desk

The upstream project is licensed under the GNU Affero General Public License,
version 3 only. Upstream copyright notices and attribution are preserved here.

Vibe Halo removes the desktop-pet presentation and retains/adapts parts of
the hook, plugin, approval transport, and lifecycle design for its bounded
multi-client integration layer.

The optional Vibe Halo Android companion and Cloudflare relay are independently
implemented extensions; no upstream mobile/remote implementation is included.
The project remains AGPL-3.0-only. Desktop dependency licenses remain packaged
with their npm modules and Electron licensing files. Android APK assets include
LICENSE, this NOTICE, and generated THIRD_PARTY_NOTICES.txt containing the exact
resolved runtime dependency coordinates, POM licensing/attribution and bundled
archive notices. Important runtime components include AndroidX/Compose, Kotlin,
kotlinx.coroutines, OkHttp/Okio, Nimbus JOSE + JWT, Firebase Messaging and
WorkManager and commonmark-java (their respective upstream licenses apply). Desktop
image references use commonmark (BSD-2-Clause) and image-size (MIT). Node cryptography uses
jose; LAN transport uses ws, bonjour-service and @peculiar/x509. Lockfiles and the
Android version catalog identify versions; generated notices identify transitive
Android artifacts. Source and modifications: https://github.com/DaliBerr/Vibe-Halo

Client icons in `src/settings-renderer/icons/` come from LobeHub Icons
(`@lobehub/icons-static-svg` 1.95.1, MIT, Copyright (c) 2023 LobeHub; license
text in that folder). The marks are trademarks of their respective owners and
are used only to identify the supported clients.
The Android client notification vectors under
`apps/android/app/src/main/res/drawable/notification_*.xml` adapt those same icons
with client-specific colors. Their MIT license is bundled in the APK as
`LOBEHUB_ICONS_LICENSE.txt`.
Additional monochrome LobeHub icons use source commit
`a177c1e817204f8ddc0c8993610ca674fc6d9767`. The Codewhale icon comes from
`codewhale-hq/Codewhale` commit `9c10aabf78761b39779d70a5746dbfe70c8f7389`
(MIT, Copyright (c) 2024-2025 DeepSeek-TUI Contributors). The Reasonix icon comes
from `esengine/DeepSeek-Reasonix` commit `e81658de81ab957d8f9f6277f6a7b48b8400261f`
(MIT, Copyright (c) 2026 Reasonix Contributors). Their original licenses are
bundled as `CODEWHALE_LICENSE.txt` and `REASONIX_LICENSE.txt`. Exact source URLs,
source digests and the notification palette are recorded in
`apps/android/artwork/notification-clients.json`.
