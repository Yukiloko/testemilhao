import "@/lib/load-env";
import { db } from "../client";

db();
console.log("Migrations applied.");
