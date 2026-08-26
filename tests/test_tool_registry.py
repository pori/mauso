"""Guards the contract between tools/registry.py (what schemas the model can
see) and agent.py (what the loop actually knows how to execute) -- these two
lists drifting apart is a silent-failure mode: a schema with no matching
`_execute_tool` branch would have the model call a tool that always errors,
and vice versa a tool `_execute_tool` handles but never advertises is just
dead code."""
from app.agent import ALL_TOOL_NAMES
from app.tools.registry import TOOL_SCHEMAS, schemas_for


def test_every_schema_is_well_formed():
    for schema in TOOL_SCHEMAS:
        assert schema["type"] == "function"
        fn = schema["function"]
        assert fn["name"]
        assert fn["description"]
        assert fn["parameters"]["type"] == "object"
        assert "properties" in fn["parameters"]


def test_schema_names_match_agent_tool_names():
    schema_names = {s["function"]["name"] for s in TOOL_SCHEMAS}
    assert schema_names == ALL_TOOL_NAMES


def test_schemas_for_filters_by_enabled_set():
    result = schemas_for({"web_search"})
    assert [s["function"]["name"] for s in result] == ["web_search"]


def test_schemas_for_empty_set_returns_nothing():
    assert schemas_for(set()) == []


def test_schemas_for_unknown_name_is_ignored():
    assert schemas_for({"not_a_real_tool"}) == []
