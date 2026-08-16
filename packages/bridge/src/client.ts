import {
  OneClickService,
  type GetExecutionStatusResponse,
  type QuoteRequest,
  type QuoteResponse,
  type SubmitDepositTxRequest,
  type SubmitDepositTxResponse,
  type TokenResponse,
} from '@defuse-protocol/one-click-sdk-typescript';

/** Narrow SDK port. Tests never need the network or the SDK singleton. */
export interface OneClickClient {
  getTokens(): Promise<TokenResponse[]>;
  getQuote(request: QuoteRequest): Promise<QuoteResponse>;
  getExecutionStatus(
    depositAddress: string,
    depositMemo?: string,
  ): Promise<GetExecutionStatusResponse>;
  submitDepositTx(request: SubmitDepositTxRequest): Promise<SubmitDepositTxResponse>;
}

export class OneClickSdkClient implements OneClickClient {
  async getTokens(): Promise<TokenResponse[]> {
    return OneClickService.getTokens();
  }

  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    return OneClickService.getQuote(request);
  }

  async getExecutionStatus(
    depositAddress: string,
    depositMemo?: string,
  ): Promise<GetExecutionStatusResponse> {
    return OneClickService.getExecutionStatus(depositAddress, depositMemo);
  }

  async submitDepositTx(request: SubmitDepositTxRequest): Promise<SubmitDepositTxResponse> {
    return OneClickService.submitDepositTx(request);
  }
}
