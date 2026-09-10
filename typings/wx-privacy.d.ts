declare namespace WechatMiniprogram {
    interface OpenPrivacyContractOption {
        success?: (result: GeneralCallbackResult) => void
        fail?: (result: GeneralCallbackResult) => void
        complete?: (result: GeneralCallbackResult) => void
    }

    interface Wx {
        /** Opens the mini program privacy contract page. */
        openPrivacyContract(option?: OpenPrivacyContractOption): void
    }
}
