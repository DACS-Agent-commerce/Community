// A verifier module that fails while loading, as one missing its own configuration would.
export {};
throw new Error("fixture verifier has no roster configured");
