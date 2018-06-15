// @flow

const StatusCodes: {[string]: number} = {
  closeNormal: 1000,
  closeGoingAway: 1001,
  closeProtocolError: 1002,
  closeUnsupported: 1003,
  closeNoStatus: 1005,
  closeAbnormal: 1006,
  unsupportedData: 1007,
  policyViolation: 1008,
  closeTooLarge: 1009,
  missingExtension: 1010,
  internalError: 1011,
  serviceRestart: 1012,
  tryAgainLater: 1013,
  tlsHandshake: 1015,
};

export default StatusCodes;
