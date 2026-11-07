# itemD Feature Tracker

This document tracks only unfinished or planned work. Completed features are
removed instead of being retained as a historical checklist.

## Next: Provider slice finalization

- [ ] Resolve configuration through the shared configuration module in the
  one-shot CLI.
- [ ] Preserve environment-only DeepSeek setup and stored TUI configuration.
- [ ] Keep replay independent from provider credentials.
- [ ] Finish provider/configuration documentation and final verification.
- [ ] Perform one live, read-only DeepSeek tool run after mocked checks pass.

## Pipeline — Not started

These features are recorded for future work only. Do not implement them as part
of the current provider-finalization checkpoint.

### Light mode

- [ ] Add a light terminal theme alongside the current dark theme.
- [ ] Keep text, borders, status colors, selection, and command discovery
  readable in both themes.
- [ ] Provide an explicit way to switch themes without changing agent or
  provider state.
