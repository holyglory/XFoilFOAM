import { Storage } from "@google-cloud/storage";
import { SolverHistoryGcsStore } from "@aerodb/core/solver-history-gcs";

export class SolverHistoryStore extends SolverHistoryGcsStore {
  constructor(storage = new Storage()) { super(storage); }
}
