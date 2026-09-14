from enum import StrEnum


class ProviderName(StrEnum):
    NETEASE = "netease"


class ConnectionStatus(StrEnum):
    IDLE = "IDLE"
    CREATING_QR = "CREATING_QR"
    WAITING_SCAN = "WAITING_SCAN"
    WAITING_CONFIRM = "WAITING_CONFIRM"
    CONNECTED = "CONNECTED"
    EXPIRED = "EXPIRED"
    FAILED = "FAILED"
    DISCONNECTED = "DISCONNECTED"


class EntityType(StrEnum):
    TRACK = "track"
    ARTIST = "artist"
    ALBUM = "album"
    PLAYLIST = "playlist"


class SyncStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PARTIAL = "PARTIAL"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    SESSION_EXPIRED = "SESSION_EXPIRED"


class StemJobStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
