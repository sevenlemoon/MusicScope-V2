import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ConnectExperience } from "./ConnectExperience";

function response(payload: object) {
  return Promise.resolve({ ok: true, json: async () => payload });
}

describe("ConnectExperience", () => {
  beforeEach(() => { global.fetch = jest.fn(); });
  afterEach(() => jest.restoreAllMocks());

  it("renders a real QR challenge and waiting state", async () => {
    const fetchMock = (global.fetch as jest.Mock)
      .mockImplementationOnce(() => response({ items: [] }) as never)
      .mockImplementationOnce(() => response({
        challenge_id: "challenge-1",
        status: "WAITING_SCAN",
        qr_url: "https://music.163.com/login?codekey=public",
        qr_image_data_url: "data:image/png;base64,c2FmZQ==",
        expires_at: "2026-09-14T12:00:00Z",
      }) as never);

    render(<ConnectExperience />);
    fireEvent.click(screen.getByRole("button", { name: "Generate QR" }));

    expect(await screen.findByText("Waiting for scan")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "NetEase Cloud Music login QR code" })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("restores a connected account after page reload", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() => response({ items: [{
      id: "connection-1",
      provider: "netease",
      status: "CONNECTED",
      nickname: "Real listener",
    }] }) as never);
    render(<ConnectExperience />);
    expect(await screen.findByText(/Signed in as/)).toHaveTextContent("Real listener");
    expect(screen.getByRole("button", { name: "Synchronize library" })).toBeInTheDocument();
  });
});
