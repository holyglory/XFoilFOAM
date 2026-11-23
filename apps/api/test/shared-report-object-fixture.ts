import { CRC32C } from "@google-cloud/storage";
import { sha256, type ReportObjectPin, type ReportObjects } from "../../sweeper/src/shared-report-objects";

// Only the GCS object transport is substituted. Pins preserve uint64 generation
// text and the content-addressed store models immutable create and exact reopen.
export function memoryReportObjects() {
  const files = new Map<string, { pin: ReportObjectPin; bytes: Buffer }>();
  let ordinal = 9007199254740993123n;
  const store: ReportObjects = {
    bucket:"disposable-hub",prefix:"progressive-reports/v1",
    async find(key) { return files.get(key)?.pin ?? null; },
    async create(key,bytes) {
      const previous=files.get(key);if(previous)return previous.pin;
      const crc=new CRC32C();crc.update(bytes);
      const pin={key,generation:String(++ordinal),size:bytes.length,sha256:sha256(bytes),crc32c:crc.toString()};
      files.set(key,{pin,bytes:Buffer.from(bytes)});return pin;
    },
    async read(pin,limit) {
      const current=files.get(pin.key);
      if(!current || current.pin.generation!==pin.generation || current.bytes.length>limit ||
          current.bytes.length!==pin.size || sha256(current.bytes)!==pin.sha256)throw new Error("Missing or corrupt test generation");
      return Buffer.from(current.bytes);
    },
  };
  return {files,store};
}
