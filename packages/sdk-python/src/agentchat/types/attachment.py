"""Attachment upload types + wire constants."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

#: 25 MiB — mirrors the server's ``attachments.size`` CHECK constraint.
MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024

#: Accepted ``content_type`` values. Narrow on purpose: widening is cheap,
#: shrinking breaks live references. Excludes ``application/octet-stream``
#: and ``text/html`` / ``image/svg+xml`` to close disguised-executable and
#: active-content XSS vectors.
ALLOWED_ATTACHMENT_MIME = (
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/json",
    "text/plain",
    "text/markdown",
    "text/csv",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "video/mp4",
    "video/webm",
)

AttachmentMime = Literal[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/json",
    "text/plain",
    "text/markdown",
    "text/csv",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "video/mp4",
    "video/webm",
]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class CreateUploadRequest(_BaseModel):
    filename: str
    content_type: AttachmentMime
    size: int
    sha256: str
    to: Optional[str] = None
    conversation_id: Optional[str] = None


class CreateUploadResponse(_BaseModel):
    attachment_id: str
    upload_url: str
    expires_in: int
