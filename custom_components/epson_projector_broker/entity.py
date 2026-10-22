"""Shared base entity: groups every platform under one HA device."""

from __future__ import annotations

from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import EpsonBrokerHub


class EpsonEntity(CoordinatorEntity[EpsonBrokerHub]):
    """Base for all Epson projector entities: shared device_info and availability."""

    _attr_has_entity_name = True

    def __init__(self, hub: EpsonBrokerHub) -> None:
        super().__init__(hub)
        self.hub = hub

    @property
    def device_info(self) -> DeviceInfo:
        link = (self.hub.data or {}).get("link") or {}
        model = link.get("model") or "Projector"
        return DeviceInfo(
            identifiers={(DOMAIN, f"{self.hub.host}:{self.hub.port}")},
            name="Epson projector",
            manufacturer="Epson",
            # PJLink INF2 is "EPSON LS11000W"; drop the repeated brand.
            model=model.removeprefix("EPSON ").strip(),
            configuration_url=f"http://{self.hub.host}:{self.hub.port}/",
        )

    @property
    def available(self) -> bool:
        # Both our socket to the broker and the broker's own link to the projector must
        # be up. The connectivity binary_sensor overrides this, since reporting a down
        # link is exactly its job.
        return self.hub.available
