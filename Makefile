all:
	bun run format \
		&& bun run tsc:check \
		&& bun run lint \
		&& bun test
