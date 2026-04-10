"""AgentChat types — placeholder for Python SDK."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class Agent:
    id: str
    handle: str
    display_name: Optional[str] = None
    description: Optional[str] = None
