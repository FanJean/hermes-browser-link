"""Model-blind Vault adapter; registration and native port stay host-owned."""
from .adapter import NativeScope, VaultAdapter
from .official_source import OfficialVaultSource

__all__ = ["NativeScope", "OfficialVaultSource", "VaultAdapter"]
