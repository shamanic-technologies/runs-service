import type { StepState } from "../../src/services/lead-states.js";
export { setAllocationInputsForTests, setLeadStatesSourceForTests } from "../../src/services/lead-states.js";

/** features-service's served map (LEAD-STATES-1024, ottawa-v1): step key -> lead state, family, rank. */
export const TEST_STEP_STATES: StepState[] = [
  { stepKey: "lead_interested", state: "lead_interested", family: "interest", rank: 1 },
  { stepKey: "conversation", state: "lead_interested", family: "interest", rank: 1 },
  { stepKey: "form_submitted", state: "lead_interested", family: "interest", rank: 1 },
  { stepKey: "signup", state: "lead_interested", family: "interest", rank: 1 },
  { stepKey: "booking_call", state: "lead_interested", family: "interest", rank: 1 },
  { stepKey: "meeting_booked", state: "meeting_booked", family: "interest", rank: 2 },
  { stepKey: "meeting_attended", state: "meeting_attended", family: "interest", rank: 3 },
  { stepKey: "paid_client", state: "paid_client", family: "interest", rank: 4 },
  { stepKey: "purchase", state: "paid_client", family: "interest", rank: 4 },
  { stepKey: "lead_visited", state: "lead_visited", family: "visit", rank: 1 },
  { stepKey: "website_visit", state: "lead_visited", family: "visit", rank: 1 },
];
