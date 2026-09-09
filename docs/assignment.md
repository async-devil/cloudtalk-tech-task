# Assignment brief

The brief this repository answers, transcribed from the PDF as received.

---

## Assignment Description

Your task is to build a system for product reviews (like on Amazon or Alza) including a frontend
app.

We prefer Typescript but feel free to use any language of your choice.

You are free to use any frameworks, databases, caching mechanisms and messaging brokers to develop
a solution.

Using agentic coding is very welcome.

### How to deliver the result

- A public Git repository with your code and configuration files
- Documentation that explains the thought process behind your implementation, including any design
  decisions or trade-offs you made, this can be done as part of project in README.md or as a PDF

### Considerations

- the project itself should be easy to setup, extendable and maintainable by other developers
- pay attention to your commit messages

*Please send the completed assignment back to us within 5 business days. Good luck!*

---

## How this repository answers it

| Brief | Where it is answered |
|---|---|
| Thought process, design decisions, trade-offs | [`docs/adr/`](adr/) — one decision per record, each with the alternatives that were rejected |
| What is actually being built — domain, screens, tables, wire | [`docs/spec/`](spec/) — the application specification |
| Units of work and their acceptance criteria | [`docs/tasks/`](tasks/) |
| Easy to set up | [`README.md`](../README.md) — one command to a running stack |
| Extendable | [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to add a module; module boundaries are machine-enforced |
| Maintainable | The gate chain in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — every architectural rule names the check that enforces it |
