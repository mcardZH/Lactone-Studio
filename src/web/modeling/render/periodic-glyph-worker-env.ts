// CPU-only locked GLModel bootstrap. No DOM or graphics objects are instantiated.
const realm=globalThis as unknown as {window:unknown;document:Record<string,unknown>};
realm.window=globalThis;realm.document={};
