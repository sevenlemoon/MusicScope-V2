class ProviderError(RuntimeError):
    """Base provider failure with a stable safe code for API mapping."""

    code = "provider_error"
    retryable = False


class ProviderNotConfigured(ProviderError):
    code = "provider_not_configured"


class ProviderCapabilityUnavailable(ProviderError):
    code = "provider_capability_unavailable"


class ProviderPlaybackUnavailable(ProviderCapabilityUnavailable):
    code = "provider_playback_unavailable"


class ProviderAuthenticationExpired(ProviderError):
    code = "provider_authentication_expired"


class ProviderTemporarilyUnavailable(ProviderError):
    code = "provider_temporarily_unavailable"
    retryable = True


class ProviderTimeout(ProviderTemporarilyUnavailable):
    code = "provider_timeout"


class ProviderParserChanged(ProviderTemporarilyUnavailable):
    code = "provider_parser_changed"
    retryable = False


class ProviderRateLimited(ProviderTemporarilyUnavailable):
    code = "provider_rate_limited"
