# Task-system SSH runtime notices

SSH2 1.17.0 and its required JavaScript runtime dependencies are distributed under their original notices in npm/. Exact installed package versions, npm integrity entries and notice SHA-256 values are recorded in RECEIPT.json.

Included: ssh2 1.17.0 (upstream declares MIT); asn1 0.2.6 (MIT); bcrypt-pbkdf 1.0.2 (upstream declares BSD-3-Clause; its complete multi-part LICENSE remains verbatim); safer-buffer 2.1.2 (MIT); tweetnacl 0.14.5 (Unlicense/public-domain dedication with fallback terms in its original LICENSE). All shipped source copyright headers are retained. ssh2 util/pagent.exe and its original pagent.c remain together within the unchanged package runtime selection.

Optional cpu-features/nan/buildcheck and sshcrypto native addon are not distributed. The unmodified upstream SSH2 code supports its JavaScript/built-in-crypto fallback. This notice is not an ABI or live SSH connection validation.

SQLite is the existing Electron 44.7.0 node:sqlite facility; no separate SQLite package is installed or bundled. Existing Electron runtime notices are retained. This collection does not re-review prior chemistry/runtime licences or approve public release.
