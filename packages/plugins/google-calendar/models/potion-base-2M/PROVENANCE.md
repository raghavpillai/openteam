# Bundled semantic-search model

Model: [minishlab/potion-base-2M](https://huggingface.co/minishlab/potion-base-2M), revision `389b9f64be5aa4ae7a6bc6fe95ef20ce485ae5da`, retrieved 2026-09-12. Model card declares MIT; the Model2Vec MIT license is included in LICENSE. The weights and tokenizer are unmodified. Runtime performs tokenization, mean pooling and L2 normalization locally; it does not contact Hugging Face or send calendar data to a model service.

SHA-256:

- model.safetensors: `f95ffde02ad06f63ae38eb9d400038cd5ccaf8411ec3cb650c6025113f96cbb8`
- tokenizer.json: `e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50`
- tokenizer_config.json: `6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567`
- config.json: `b2a89173391ca774c2d7323090a993a9a1553faa5b40eb37bb7cec6685fbea47`

This compact English model supplies semantic retrieval in the OSS adapter. Its ranking is not Google's proprietary ranking. Exact provider order, language coverage and relevance scores are not claimed to be identical. The live account's complete event inventory is retrieved with pagination and incrementally synchronized; cancelled events are removed. Very large calendars above 100,000 events require a bounded list_events query. Results disclose the model, index completeness and retrieval mode.
