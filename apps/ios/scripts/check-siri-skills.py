#!/usr/bin/env python3
"""Validate Apple's constrained app-skills format, plus compiled output when supplied."""
import json
import plistlib
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
bundle = root / 'Resources/Skills.skillsbundle'
skills = bundle / 'Skills'
assert list(bundle.iterdir()) == [skills], 'A skills bundle contains only Skills/'
expected = {'delegate-to-bot', 'review-conversation', 'run-saved-routine'}
assert {p.name for p in skills.iterdir()} == expected
for directory in skills.iterdir():
    assert re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', directory.name) and len(directory.name) <= 64
    assert [p.name for p in directory.iterdir()] == ['SKILL.md'], 'Apple skills cannot bundle scripts or references'
    text = (directory / 'SKILL.md').read_text()
    assert text.startswith('---\n')
    header, body = text[4:].split('\n---\n', 1)
    fields = dict(line.split(': ', 1) for line in header.splitlines())
    assert set(fields) == {'name', 'description'}
    assert fields['name'] == directory.name
    assert 0 < len(fields['description']) <= 1024
    assert body.strip() and len(body) <= 10_000
project = (root / 'OpenTeamNative.xcodeproj/project.pbxproj').read_text()
assert 'Resources/Skills.skillsbundle' in project and 'wrapper.skillsbundle' in project
if len(sys.argv) > 1:
    metadata = Path(sys.argv[1]) / 'Metadata.appintents'
    assert (metadata / 'Skills.skillsc').is_file(), 'Xcode did not compile the skills bundle'
    actions = json.loads((metadata / 'extract.actionsdata').read_text())
    # Inspect the compiler's output rather than assuming a Swift conformance was extracted.
    intents = actions['actions']
    compiled = plistlib.loads((metadata / 'Skills.skillsc').read_bytes())
    assert set(compiled['SKILLS']) == expected, 'Compiled skills differ from source'
    tools = {'SendBotTaskIntent', 'FindTeamMessagesIntent', 'RunTeamRoutineIntent',
             'OpenTeamBotIntent', 'OpenTeamConversationIntent', 'OpenTeamMessageIntent',
             'SendTeamConversationMessageIntent', 'DraftTeamConversationMessageIntent'}
    for name in tools:
        action = intents[name]
        assert 'com.apple.link.systemProtocol.ToolIntent' in action.get('systemProtocols', []), f'{name} was not exported as a Siri tool'
        assert action['authenticationPolicy'] == 1, f'{name} must require authentication'
    for name, schema in [('SendTeamSiriMessage', 'messages.sendMessage'), ('DraftTeamSiriMessage', 'messages.draftMessage')]:
        assert schema in {s['publicIdentifier'] for s in intents[name]['assistantDefinedSchemas']}
    for name, entity in actions['entities'].items():
        assert entity['authenticationPolicy'] == 1, f'{name} must require authentication'
print('Siri app skills format and wiring passed' + ('; compiled tools/skills passed' if len(sys.argv) > 1 else ''))
