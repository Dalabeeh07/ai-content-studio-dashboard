"use client";

// Uploads a File directly to a Supabase Storage signed-upload-URL, with real
// upload progress - used by CampaignVideosPanel.tsx's upload zone.
//
// @supabase/storage-js's own `uploadToSignedUrl()` does the same request but
// via fetch() under the hood, which exposes no upload-progress event in any
// browser today. This mirrors that method's exact request shape (PUT, a
// FormData body with a 'cacheControl' field and an unnamed file field, same
// `/object/upload/sign/{bucket}/{path}?token=...` endpoint - see
// node_modules/@supabase/storage-js/src/packages/StorageFileApi.ts) but over
// a raw XMLHttpRequest so `upload.onprogress` is available. `apikey` /
// `Authorization` are the two headers every Supabase REST/Storage request
// needs; NEXT_PUBLIC_SUPABASE_ANON_KEY is already embedded client-side
// elsewhere in this dashboard (lib/supabase.ts's browserClient), so reusing
// it here isn't a new exposure.
export function uploadWithProgress(
  bucket: string,
  path: string,
  token: string,
  file: File,
  onProgress: (fraction: number) => void
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  return new Promise((resolve, reject) => {
    if (!supabaseUrl || !anonKey) {
      reject(new Error("Supabase is not configured in this environment."));
      return;
    }

    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = new URL(`${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${encodedPath}`);
    url.searchParams.set("token", token);

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url.toString());
    xhr.setRequestHeader("apikey", anonKey);
    xhr.setRequestHeader("Authorization", `Bearer ${anonKey}`);
    xhr.setRequestHeader("x-upsert", "false");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText.slice(0, 300)}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));

    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    xhr.send(body);
  });
}
