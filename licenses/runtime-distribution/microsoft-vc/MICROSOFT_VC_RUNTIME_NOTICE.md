# Microsoft Visual C++ Runtime: current candidate members

Read the original MICROSOFT_VC_RUNTIME_LICENSE.rtf before installing or using the applicable Microsoft runtime components. If you do not accept its terms, do not install or use those components. The TXT companion is unchanged convenience text; the original RTF controls. Ordinary end users do not need to acquire or install Visual Studio. Community developer conditions are not imposed on ordinary runtime users. Publisher qualification is assessed separately; its evidence remains private.

This independent current table includes all 13 actual VC locations, including the NumPy wheel's private basename. The earlier twelve-row historical table is preserved unchanged. All thirteen current locations have exact official-archive correspondence. The separate NumPy member also retains its unmodified official-wheel/RECORD provenance and valid Microsoft signature; its exact Microsoft 14.40.33810 carrier and original EULA are now matched, as described below. It is included in the Microsoft runtime recipient conditions; NumPy BSD and the SY-Studio own license do not relicense that Microsoft code.

| Candidate path | Bytes | SHA-256 | Source evidence |
| --- | ---: | --- | --- |
| `runtime/resources/chemistry/_internal/concrt140.dll` | 324720 | `8bf82e025265d30fb25fda7161f8e8d73b96f83fde10f95b0fc4887bd6b09b5e` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/msvcp140.dll` | 557648 | `8f141b4454fa78db34bc1f28c571b4da0e00cd2c43f7ad0e282f313036826aae` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/msvcp140_1.dll` | 35952 | `4d547db5eb3aabfb1bbe25604c37fe1c253fba3bf25fae654d78d7cd44b7dd3d` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/msvcp140_2.dll` | 280176 | `8f481c24983fe695e29df1bff55a44072a1c96927322e70844ef5e6a58ecf8d1` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/msvcp140_atomic_wait.dll` | 50288 | `44843c7541b75e30f8ff191bf5d5785a0885f9d694f6e10e545c3346acd5d0c3` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/msvcp140_codecvt_ids.dll` | 31880 | `2a61faa8f81e397e04e8afcd82be7ca95309b144f148b2bd8e6a1e93bef04bda` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/numpy.libs/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll` | 575056 | `a4c2229bdc2a2a630acdc095b4d86008e5c3e3bc7773174354f3da4f5beb9cde` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/vcamp140.dll` | 418896 | `009cfafab5d38e0e10f827f8baf09373005ba93c8e89922c5e6937328ff5fc3c` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/vccorlib140.dll` | 352336 | `6fbc46f26f0ed1d6ea837890e60bb2c5b5cf7e1df7c66d16267b8a9fd3545f9c` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/vcruntime140.dll` | 124496 | `0205071c36c17f1efbd70178c852cb7d49985c484202752b8704b7ac6b184e60` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/vcruntime140_1.dll` | 49744 | `963e45edd064545962e216c12d68071ced94dc8e11862a18f07f14eb2690a57c` | exact-official-archive-member |
| `runtime/resources/chemistry/_internal/vcruntime140_threads.dll` | 38480 | `18186dd0af0e8cb6b0111adb585ad70dd555c1c6950eca7ba3a4900558d6eb37` | exact-official-archive-member |
| `runtime/resources/xtb/bin/VCRUNTIME140.dll` | 124496 | `0205071c36c17f1efbd70178c852cb7d49985c484202752b8704b7ac6b184e60` | exact-official-archive-member |

## NumPy private MSVC member

The independent basename `msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll` is 575056 bytes, SHA-256 `a4c2229bdc2a2a630acdc095b4d86008e5c3e3bc7773174354f3da4f5beb9cde`. Its original filename is msvcp140.dll, File/ProductVersion 14.40.33810.0. The locked official NumPy 2.4.6 wheel and its RECORD preserve these exact bytes; Microsoft Authenticode is valid. Main adopts the VS2022 17.10/v14.40 REDIST category and the separately held publisher qualification as the targeted distribution basis.

The exact Microsoft Visual C++ 2015–2022 Redistributable (x64) 14.40.33810.0 carrier is 25,397,512 bytes, SHA-256 `3642e3f95d50cc193e4b5a0b0ffbf7fe2c08801517758b4c8aeb7105a091208a`. Its Microsoft Authenticode signature is valid. The carrier member `cab@650704/a12/cab@0/msvcp140.dll_amd64` exactly matches the NumPy-private DLL bytes and SHA-256 above. The Microsoft/winget-pkgs manifest pinned in MICROSOFT_VC_RUNTIME_SOURCES.json independently supplies the version-specific official download URL and SHA-256.

The carrier's original English `license.rtf`, mapped to `cab@463360/u4` by its Burn manifest, is 9,235 bytes and SHA-256 `8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b`. It is byte-identical to the existing MICROSOFT_VC_RUNTIME_LICENSE.rtf supplied here. The NumPy wheel itself still does not include a Microsoft EULA; this recipient attachment is bound to the exact Microsoft carrier instead. No DLL or license text was changed to obtain this correspondence.

The publisher's existing Visual Studio Community 2022 qualification remains the separate distribution basis under the applicable Microsoft terms and VS2022 REDIST list. Original runtime terms, notices and recipient acceptance conditions continue to apply; ordinary runtime users need not accept Community developer conditions or install Visual Studio. Source correspondence and signature verification do not themselves authorize public release. Public approval remains false pending the separate final release decision.
