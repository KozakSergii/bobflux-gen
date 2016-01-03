import * as bf from 'bobflux';
import * as ns from './stateWithNestedState';

export interface IApplicationState extends bf.IState {
    stringValue: string
    baseTypes: ns.INestedState
}