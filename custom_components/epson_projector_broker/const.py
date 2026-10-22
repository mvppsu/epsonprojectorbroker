"""Constants for the Epson Projector Broker integration."""

DOMAIN = "epson_projector_broker"

CONF_TOKEN = "token"

DEFAULT_PORT = 8096
DEFAULT_NAME = "Epson projector"

PLATFORMS = [
    "media_player",
    "switch",
    "sensor",
    "binary_sensor",
]

# Broker power states (broker/src/projector.js POWER_STATES, plus "unknown").
POWER_STATES = ["off", "warming", "on", "cooling", "unknown"]
