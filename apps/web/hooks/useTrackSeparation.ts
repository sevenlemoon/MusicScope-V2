"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, ApiRequestError } from "@/lib/api-client";

// Multiple visible occurrences of a song share the same in-flight creation.
const requests = new Map<string, Promise<{ id: string }>>();
export function useTrackSeparation(trackId: string, fallbackError: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const live = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const start = async () => {
    if (locked.current) return;
    locked.current = true; setPending(true); setError(null);
    let navigating = false;
    try {
      let request = requests.get(trackId);
      if (!request) {
        request = apiRequest<{ id: string }>(`/api/v1/studio/tracks/${encodeURIComponent(trackId)}/jobs?model=htdemucs_6s`, { method: "POST" });
        requests.set(trackId, request);
        void request.finally(() => requests.delete(trackId)).catch(() => undefined);
      }
      const job = await request;
      navigating = true;
      if (live.current) { window.dispatchEvent(new Event("musicscope:leaving-library")); router.push(`/studio/jobs/${encodeURIComponent(job.id)}?track=${encodeURIComponent(trackId)}`); }
    } catch (reason) {
      if (live.current) setError(reason instanceof ApiRequestError ? reason.message : fallbackError);
    } finally {
      if (!navigating) { locked.current = false; if (live.current) setPending(false); }
    }
  };
  return { start, pending, error };
}
