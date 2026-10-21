export type PlaybackRequest = Readonly<{ instance: symbol; generation: number }>;

export type PlaybackParticipant = {
  claim: () => PlaybackRequest | null;
  isCurrent: (request: PlaybackRequest | null) => boolean;
  isOwner: () => boolean;
  pause: (request?: PlaybackRequest) => void;
  dispose: () => void;
};

// Registration is passive. Only an explicit play intent can interrupt the owner.
export function createPlaybackCoordinator() {
  let owner: { request: PlaybackRequest; participant: PlaybackParticipant } | null = null;

  return {
    register(kind: "player" | "studio", stop: () => void): PlaybackParticipant {
      const instance = Symbol(kind);
      let generation = 0;
      let disposed = false;
      const participant: PlaybackParticipant = {
        claim() {
          if (disposed) return null;
          owner?.participant.pause();
          const request = { instance, generation: ++generation };
          owner = { request, participant };
          return request;
        },
        isCurrent(request) {
          return !disposed && request !== null && request.instance === instance &&
            request.generation === generation && owner?.request === request;
        },
        isOwner() {
          return !disposed && owner?.request.instance === instance;
        },
        pause(request) {
          // A late catch/finally must never stop a newer request, even on this instance.
          if (disposed || (request && !participant.isCurrent(request))) return;
          ++generation;
          if (owner?.request.instance === instance) owner = null;
          stop();
        },
        dispose() {
          if (disposed) return;
          participant.pause();
          disposed = true;
        },
      };
      return participant;
    },
  };
}

// Browser-module singleton; participants are created by effects, never during render.
export const playbackCoordinator = createPlaybackCoordinator();
