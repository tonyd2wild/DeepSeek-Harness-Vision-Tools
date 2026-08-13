# Tell the agent what you did

`dsh` reads **`$DSH_HOME/AGENTS.md` into every session**. When you give a
text-only brain eyes, that file is where you explain the new ability, because a
model that suddenly "sees" images will reason about *why* and get it wrong.

## The trap

Once the proxy is live, the agent starts receiving image descriptions inline and
often concludes it was switched onto a multimodal model. Paraphrasing an observed
DeepSeek session after this shipped: the agent announced that it could now see
images directly and that the session must be running on a vision model route, not
on DeepSeek.

It was still DeepSeek. It read a `[Image: ...]` description and inferred a model
switch. Left uncorrected it will assert "I can see" about pixels it never
received, and state fine detail the small describer may have gotten wrong.

The fix is to write the truth into `AGENTS.md`. This also makes it the right home
for "which picker entry is which," so an agent can answer *what am I running on*
by reading config instead of guessing from behaviour.

## Copy-paste snippet

Copy this into `$DSH_HOME/AGENTS.md` and replace `<model>` with your brain's name.

```markdown
# You are <model>. You are not multimodal.

If an image appears in your context already described in words, nothing switched
you to a vision model. A local proxy intercepts images, has a vision model
describe them, and replaces them with `[Image: ...]` text before they reach you.

There is also an `analyze_image` tool for image files on disk: you pass a path,
it returns a text description the same way. Either way you are reading words, not
pixels.

Say "the description indicates...", not "I can see...". You cannot verify pixels.
The describer is small and unreliable on small text, so flag uncertainty rather
than asserting fine detail.
```
