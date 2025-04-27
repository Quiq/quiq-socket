import QuiqSocket, {
  Events,
  FatalErrors,
  FatalErrorCallbackData as FEData,
  ConnectionLossReasons,
} from './QuiqSockets';

export {QuiqSocket, Events, FatalErrors, ConnectionLossReasons};

export type FatalErrorCallbackData = FEData;

export default QuiqSocket;
