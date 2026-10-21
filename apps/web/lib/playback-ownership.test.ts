import { createPlaybackCoordinator } from "./playback-ownership";

test("registration is passive; claims interrupt only the previous owner", () => {
  const coordinator = createPlaybackCoordinator();
  const stopPlayer = jest.fn();
  const player = coordinator.register("player", stopPlayer);
  const first = player.claim();
  const stopStudio = jest.fn();
  const studio = coordinator.register("studio", stopStudio);
  expect(player.isCurrent(first)).toBe(true);
  expect(stopPlayer).not.toHaveBeenCalled();
  const second = studio.claim();
  expect(stopPlayer).toHaveBeenCalledTimes(1);
  expect(player.isCurrent(first)).toBe(false);
  expect(studio.isCurrent(second)).toBe(true);
  player.dispose();
  expect(studio.isCurrent(second)).toBe(true);
  studio.dispose();
});

test("instance, generation and ownership all matter; stale pause cannot cancel a new request", () => {
  const coordinator = createPlaybackCoordinator();
  const stop = jest.fn();
  const player = coordinator.register("player", stop);
  const old = player.claim()!;
  const current = player.claim()!;
  expect(old.instance).toBe(current.instance);
  expect(old.generation).not.toBe(current.generation);
  expect(player.isCurrent(old)).toBe(false);
  stop.mockClear();
  player.pause(old);
  expect(stop).not.toHaveBeenCalled();
  expect(player.isCurrent(current)).toBe(true);
  player.pause(current);
  expect(player.isOwner()).toBe(false);
  player.pause();
  player.dispose();
  player.dispose();
  expect(player.claim()).toBeNull();
});

test("duplicate registration and old cleanup cannot release a replacement of the same kind", () => {
  const coordinator = createPlaybackCoordinator();
  const old = coordinator.register("studio", jest.fn());
  const first = old.claim()!;
  const replacement = coordinator.register("studio", jest.fn());
  const second = replacement.claim()!;
  expect(first.instance).not.toBe(second.instance);
  old.pause(first);
  old.dispose();
  old.dispose();
  expect(replacement.isCurrent(second)).toBe(true);
  replacement.dispose();
});
