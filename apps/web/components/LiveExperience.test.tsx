import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LiveEventDetail } from "@/components/LiveEventDetail";
import {
  ArtistLiveSection,
  EventCard,
  HomeLiveTeaser,
  LiveExperience,
  formatEventTime,
  liveStateTitle,
} from "@/components/LiveExperience";
import type { components } from "@/lib/api-schema.generated";

type LiveEvent = components["schemas"]["ConcertEventResponse"];

const event: LiveEvent = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Verified live event",
  primary_artist_name: "milet",
  performers: [{ name: "milet", provider_identities: { ticketmaster: "artist-1" } }],
  start_date: "2027-03-14",
  start_time: null,
  timezone: "Asia/Tokyo",
  venue_name: "Tokyo Garden Theater",
  city: "Tokyo",
  country: "JP",
  artwork_url: null,
  event_url: "https://events.example/event-1",
  ticket_url: "https://tickets.example/event-1",
  status: "onsale",
  observed_at: "2026-09-17T00:00:00Z",
  last_refreshed_at: "2026-09-17T00:00:00Z",
  sources: [{
    provider: "ticketmaster",
    provider_event_id: "tm-1",
    event_url: "https://events.example/event-1",
    ticket_url: "https://tickets.example/event-1",
    status: "onsale",
    observed_at: "2026-09-17T00:00:00Z",
    last_refreshed_at: "2026-09-17T00:00:00Z",
  }],
  personalization_evidence: [],
};

function response(payload: object, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

function feed(events: LiveEvent[] = [event], status = "OK") {
  return {
    status,
    coverage_message: events.length
      ? "Upcoming events returned by the currently available concert sources."
      : "No upcoming events were returned by the currently available concert sources.",
    events,
    provider_states: { ticketmaster: "HEALTHY" },
    generated_at: "2026-09-17T00:00:00Z",
    stale: false,
  };
}

test("date-only events never render a fabricated midnight", () => {
  expect(formatEventTime(event)).toBe("Date confirmed · time pending");
  render(<EventCard event={event} />);
  expect(screen.getByText("Date confirmed · time pending")).toBeInTheDocument();
  expect(screen.queryByText(/00:00/)).not.toBeInTheDocument();
});

test.each([
  ["ARTIST_NOT_FOUND", "No exact artist match was returned."],
  ["NO_UPCOMING_EVENTS", "No upcoming events were returned."],
  ["AMBIGUOUS_ARTIST", "This artist name is ambiguous."],
  ["PROVIDER_NOT_CONFIGURED", "Concert search needs a provider key."],
  ["PROVIDER_UNAVAILABLE", "Concert sources are temporarily unavailable."],
  ["PROVIDER_RATE_LIMITED", "The concert source is taking a breath."],
  ["PARTIAL_RESULTS", "Only partial verified results are available."],
])("renders distinct coverage language for %s", (status, expected) => {
  expect(liveStateTitle(status)).toBe(expected);
});

describe("R3 Live experience", () => {
  beforeEach(() => {
    global.fetch = jest.fn((input, init) => {
      const url = String(input);
      if (url.includes("/live/preferences") && init?.method === "PATCH") {
        return response(JSON.parse(String(init.body))) as never;
      }
      if (url.includes("/live/preferences")) return response({ country: null, city: null }) as never;
      if (url.includes("/live/providers")) return response([{
        provider: "ticketmaster", tier: "core", enabled: true, health: "HEALTHY", capabilities: ["ARTIST_SEARCH", "EVENT_SEARCH"],
      }]) as never;
      if (url.includes("/live/search")) return response({
        query: "milet",
        status: "OK",
        coverage_message: "Upcoming events returned by the currently available concert sources.",
        events: [event],
        artist_matches: [{ provider: "ticketmaster", provider_artist_id: "artist-1", name: "milet" }],
        provider_states: { ticketmaster: "HEALTHY" },
        provider_results: [{ provider: "ticketmaster", status: "SUCCESS", result_count: 1, latency_ms: 42, match_state: "MATCHED" }],
        cache_state: "miss",
        generated_at: "2026-09-17T00:00:00Z",
      }) as never;
      if (url.includes("/live/events/")) return response(event) as never;
      if (url.includes("/artists/artist-1/live")) return response(feed()) as never;
      if (url.includes("/live")) return response(feed()) as never;
      throw new Error(`Unexpected request ${url}`);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test("searches any artist, preserves the query, and clears back to Live For You", async () => {
    render(<LiveExperience />);
    expect(await screen.findByText("Verified live event")).toBeInTheDocument();
    const input = screen.getByLabelText("Artist concert search");
    fireEvent.change(input, { target: { value: "milet" } });
    fireEvent.click(screen.getByRole("button", { name: "Search artist" }));
    expect(await screen.findByText("Results for milet")).toBeInTheDocument();
    expect(screen.getByText("SUCCESS · 1")).toBeInTheDocument();
    expect(input).toHaveValue("milet");
    expect(new URLSearchParams(window.location.search).get("q")).toBe("milet");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Upcoming events")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false);
  });

  test("applies date filters and persists only explicit location choices", async () => {
    render(<LiveExperience />);
    await screen.findByText("Verified live event");
    fireEvent.click(screen.getByRole("button", { name: "Next 3 months" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("date_filter=three_months"), expect.anything(),
    ));
    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "jp" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Tokyo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/live/preferences"),
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"country":"JP"') }),
    ));
  });

  test("event detail renders venue, provenance, status, and a real external ticket action", async () => {
    render(<LiveEventDetail id={event.id} />);
    expect(await screen.findByRole("heading", { name: "Verified live event" })).toBeInTheDocument();
    expect(screen.getByText("Tokyo Garden Theater")).toBeInTheDocument();
    expect(screen.getByText("ticketmaster")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View tickets" })).toHaveAttribute("href", "https://tickets.example/event-1");
  });

  test("Home and Artist integrations read only their cached endpoints", async () => {
    const { rerender } = render(<HomeLiveTeaser />);
    expect(await screen.findByText(/upcoming event/)).toBeInTheDocument();
    rerender(<ArtistLiveSection artistId="artist-1" />);
    expect(await screen.findByRole("heading", { name: "Upcoming Live" })).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/live?limit=3"), expect.anything());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/artists/artist-1/live"), expect.anything());
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/live/refresh"), expect.anything());
  });
});
