GOCMDS := build test vet
.PHONY: $(GOCMDS)
$(GOCMDS):
	go $@ ./...

test: build
