# Independent libxtb re-link recipe

Use `python relink.py --zig PATH_TO_MATCHING_ZIG --output NEW_OUTPUT_DIRECTORY` from this directory. The script requires an explicit Zig 0.17.0 executable matching the lock, verifies all eight included inputs, creates a new output directory, and never replaces a product installation. The compiler and its installed support files remain a normal user-provided build tool. The new output need not have the original DLL hash because build identifiers may change.

This independent recipe was executed successfully. Its new DLL was loaded by the actual ES PES Python provider using a manifest describing the new bytes; API 20000, dependency paths and thread controls were accepted. No molecule or energy/gradient evaluation was performed.

The three copied historical Node control modules under project/scripts/ are internal comparison material and are excluded from the proposed public material projection: one contains a developer desktop default. The independent Python recipe replaces the need to distribute those copied helper modules here; it does not change the product's original source. Main's final product source export must still include its necessary build code in the approved public form.

To use an interface-compatible modified library: preserve the x86-64 API 20000 and the declared dependencies, generate a manifest for the new actual library and parameters, and use a matching locally built/admitted product configuration. The final public desktop package must document and validate that configuration/admission path. This library-level validation does not assert that replacing only a DLL without updating integrity metadata is supported, nor does it certify the final desktop admission UI.
