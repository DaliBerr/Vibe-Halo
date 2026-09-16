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
WorkManager (their respective upstream licenses apply). Node cryptography uses
jose; LAN transport uses ws, bonjour-service and @peculiar/x509. Lockfiles and the
Android version catalog identify versions; generated notices identify transitive
Android artifacts. Source and modifications: https://github.com/DaliBerr/Vibe-Halo
