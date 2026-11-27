import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** On Windows a recently opened destination can briefly deny replacement. */
export async function publishFile(staged: string, destination: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      await rename(staged, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await delay(10 * 2 ** attempt, undefined, { signal });
    }
  }
}

/** Replace the destination only when the complete file is ready, including during concurrent writes. */
export async function writeFileAtomic(file: string, data: Buffer): Promise<void> {
  const part = `${file}.${randomUUID()}.part`;
  try {
    await writeFile(part, data);
    await publishFile(part, file);
  } finally {
    await rm(part, { force: true });
  }
}
