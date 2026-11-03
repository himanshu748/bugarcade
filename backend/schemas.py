import hashlib
import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Identifier = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")]
ShortText = Annotated[str, StringConstraints(max_length=1000)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Click(StrictModel):
    type: Literal["click"]
    target: Identifier


class Fill(StrictModel):
    type: Literal["fill"]
    target: Identifier
    value: Annotated[str, StringConstraints(max_length=500)]


class Release(StrictModel):
    type: Literal["release"]
    request: Identifier


class Wait(StrictModel):
    type: Literal["wait"]
    target: Identifier
    value: Annotated[str, StringConstraints(max_length=500)]


Action = Annotated[Click | Fill | Release | Wait, Field(discriminator="type")]


class Assertion(StrictModel):
    target: Identifier
    operator: Literal["equals", "contains", "count"]
    expected: Annotated[str, StringConstraints(max_length=500)] | int

    @model_validator(mode="after")
    def correct_type(self):
        if self.operator == "count" and (type(self.expected) is not int or self.expected < 0):
            raise ValueError("count requires a nonnegative integer")
        if self.operator != "count" and not isinstance(self.expected, str):
            raise ValueError("text assertions require text expected values")
        return self


class Completion(StrictModel):
    target: Identifier
    value: Annotated[str, StringConstraints(max_length=500)]


class ScheduleEntry(StrictModel):
    id: Identifier
    key: Identifier
    response: Any
    status: int = Field(ge=200, le=599)
    optional: bool = False

    @model_validator(mode="after")
    def bounded_response(self):
        if len(json.dumps(self.response, ensure_ascii=False, allow_nan=False)) > 16000:
            raise ValueError("schedule response exceeds 16,000 characters")
        return self


class Manifest(StrictModel):
    id: Identifier = "submitted-app"
    title: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    goal: ShortText
    allowedTargets: list[Identifier] = Field(min_length=1, max_length=40)
    assertion: Assertion
    completion: Completion
    schedule: list[ScheduleEntry] = Field(max_length=12)
    actions: list[Action] = Field(default_factory=list, max_length=12)
    initialActions: list[Action] = Field(default_factory=list, max_length=12)
    explanation: ShortText = ""
    hint: ShortText = ""
    seed: int = 0

    @model_validator(mode="after")
    def consistent(self):
        if len({entry.id for entry in self.schedule}) != len(self.schedule):
            raise ValueError("schedule IDs must be unique")
        if self.assertion.target not in self.allowedTargets or self.completion.target not in self.allowedTargets:
            raise ValueError("assertion and completion targets must be declared")
        validate_actions(self.actions, self)
        validate_actions(self.initialActions, self)
        return self


def validate_actions(actions: list[Action], manifest: Manifest) -> None:
    requests = {entry.id for entry in manifest.schedule}
    for action in actions:
        if isinstance(action, Release):
            if action.request not in requests:
                raise ValueError("action references undeclared request")
        elif action.target not in manifest.allowedTargets:
            raise ValueError("action references undeclared target")


class Proposal(StrictModel):
    actions: list[Action] = Field(min_length=1, max_length=12)
    candidateAssertion: Assertion
    rationale: Annotated[str, StringConstraints(max_length=2000)]


class JobRequest(StrictModel):
    challengeId: Identifier | None = None
    projectId: Identifier | None = None
    mode: Literal["recorded", "live"] = "recorded"
    idempotencyKey: Annotated[str, StringConstraints(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")]

    @model_validator(mode="after")
    def one_source(self):
        if (self.challengeId is None) == (self.projectId is None):
            raise ValueError("choose exactly one challengeId or projectId")
        if self.projectId and self.mode != "live":
            raise ValueError("uploaded code requires live Modal execution")
        return self


def digest(value: Any) -> str:
    if isinstance(value, BaseModel):
        value = value.model_dump()
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def invariant_hash(manifest: Manifest) -> str:
    return digest({"assertion": manifest.assertion.model_dump(), "completion": manifest.completion.model_dump()})
