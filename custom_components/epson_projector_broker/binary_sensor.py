"""Binary sensors: projector reachability and PJLink-reported faults."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import EpsonBrokerHub
from .entity import EpsonEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    hub: EpsonBrokerHub = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([EpsonLinkBinarySensor(hub), EpsonProblemBinarySensor(hub)])


class EpsonLinkBinarySensor(EpsonEntity, BinarySensorEntity):
    _attr_translation_key = "link"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    def __init__(self, hub: EpsonBrokerHub) -> None:
        super().__init__(hub)
        self._attr_unique_id = f"{hub.host}:{hub.port}-link"

    @property
    def available(self) -> bool:
        # Deliberately not self.hub.available (which also requires link.connected):
        # this entity's whole purpose is to report link.connected, including when it's
        # False. It only needs our own socket to the broker to be up to answer that.
        return self.hub.ws_connected

    @property
    def is_on(self) -> bool | None:
        link = (self.hub.data or {}).get("link") or {}
        return link.get("connected")


class EpsonProblemBinarySensor(EpsonEntity, BinarySensorEntity):
    _attr_translation_key = "problem"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, hub: EpsonBrokerHub) -> None:
        super().__init__(hub)
        self._attr_unique_id = f"{hub.host}:{hub.port}-problem"

    @property
    def is_on(self) -> bool | None:
        return (self.hub.data or {}).get("problem")

    @property
    def extra_state_attributes(self) -> dict:
        return (self.hub.data or {}).get("errors") or {}
