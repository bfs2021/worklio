"""Request/response schemas for Worklio AI (app/api/routes/ai.py)."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ComposeAction = Literal[
    "improve", "shorter", "longer", "friendlier", "formal", "fix", "translate", "bullets"
]
SummaryRange = Literal["unread", "24h", "7d", "all"]


class AIStatusOut(BaseModel):
    enabled: bool
    model: str
    features: list[str]


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    conversation_id: uuid.UUID | None = None


class SummaryIn(BaseModel):
    range: SummaryRange = "unread"


class ComposeIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    action: ComposeAction
    target_language: str | None = Field(default=None, max_length=60)


class ComposeOut(BaseModel):
    text: str
    truncated: bool = False


class TranslateIn(BaseModel):
    target_language: str = Field(min_length=2, max_length=60)


class TranslateOut(BaseModel):
    text: str
    detected_language: str


class TaskOut(BaseModel):
    title: str
    assignee_id: uuid.UUID | None
    due_date: date | None
    source_message_id: uuid.UUID


class TasksOut(BaseModel):
    tasks: list[TaskOut]


class CitationOut(BaseModel):
    n: int
    message_id: uuid.UUID
    channel_id: uuid.UUID
    parent_id: uuid.UUID | None
    author_id: uuid.UUID
    snippet: str
    created_at: datetime
    channel_name: str | None = None
    author_name: str | None = None


class AITurnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    role: Literal["user", "assistant"]
    content: str
    citations: list[CitationOut] = []
    created_at: datetime


class AIConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    created_at: datetime
    updated_at: datetime


class AIConversationDetailOut(AIConversationOut):
    turns: list[AITurnOut]


# --- Structured outputs requested from Claude (kept JSON-schema friendly: plain types) ------


class LLMTranslation(BaseModel):
    text: str
    detected_language: str


class LLMTask(BaseModel):
    title: str
    assignee_ref: int | None
    due_date: str | None
    source_ref: int


class LLMTaskList(BaseModel):
    tasks: list[LLMTask]
