from app.domain.enums import ConnectionStatus

ALLOWED_TRANSITIONS: dict[ConnectionStatus, frozenset[ConnectionStatus]] = {
    ConnectionStatus.IDLE: frozenset({ConnectionStatus.CREATING_QR}),
    ConnectionStatus.CREATING_QR: frozenset(
        {ConnectionStatus.WAITING_SCAN, ConnectionStatus.FAILED}
    ),
    ConnectionStatus.WAITING_SCAN: frozenset(
        {
            ConnectionStatus.WAITING_CONFIRM,
            ConnectionStatus.CONNECTED,
            ConnectionStatus.EXPIRED,
            ConnectionStatus.FAILED,
        }
    ),
    ConnectionStatus.WAITING_CONFIRM: frozenset(
        {ConnectionStatus.CONNECTED, ConnectionStatus.EXPIRED, ConnectionStatus.FAILED}
    ),
    ConnectionStatus.CONNECTED: frozenset(
        {ConnectionStatus.EXPIRED, ConnectionStatus.FAILED, ConnectionStatus.DISCONNECTED}
    ),
    ConnectionStatus.EXPIRED: frozenset({ConnectionStatus.CREATING_QR, ConnectionStatus.DISCONNECTED}),
    ConnectionStatus.FAILED: frozenset({ConnectionStatus.CREATING_QR, ConnectionStatus.DISCONNECTED}),
    ConnectionStatus.DISCONNECTED: frozenset({ConnectionStatus.CREATING_QR}),
}


def transition_connection_state(
    current: ConnectionStatus, target: ConnectionStatus
) -> ConnectionStatus:
    if target not in ALLOWED_TRANSITIONS[current]:
        raise ValueError(f"Invalid connection transition: {current.value} -> {target.value}")
    return target


NETEASE_QR_CODE_STATES: dict[int, ConnectionStatus] = {
    800: ConnectionStatus.EXPIRED,
    801: ConnectionStatus.WAITING_SCAN,
    802: ConnectionStatus.WAITING_CONFIRM,
    803: ConnectionStatus.CONNECTED,
}


def netease_qr_code_to_state(code: int) -> ConnectionStatus:
    try:
        return NETEASE_QR_CODE_STATES[code]
    except KeyError as exc:
        raise ValueError("Unknown NetEase QR status code") from exc

