export interface GcsGenerationRequest {
  uri?: unknown;
  qs?: Record<string, unknown>;
}

export interface GcsGenerationInterceptor {
  request(options: GcsGenerationRequest): {
    uri: string;
    qs: Record<string, unknown>;
  };
}

export interface GcsGenerationTarget {
  interceptors: { push(interceptor: GcsGenerationInterceptor): number };
}

/** Storage 7.16 rounds FileOptions.generation through Number. Override the
 * final metadata/media query instead, preserving unrelated request options. */
export function pinExactGcsGeneration<T extends GcsGenerationTarget>(
  file: T,
  generation: string,
): T {
  if (
    typeof generation !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(generation) ||
    BigInt(generation) > 18_446_744_073_709_551_615n
  )
    throw new Error("GCS generation must be an exact unsigned decimal string");
  file.interceptors.push({
    request(options) {
      if (typeof options.uri !== "string")
        throw new Error("GCS request is missing a string URI");
      return {
        ...options,
        uri: options.uri,
        qs: { ...options.qs, generation },
      };
    },
  });
  return file;
}
