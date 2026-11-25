# Aliyun PNVS protocol evidence

Official documentation retrieved on 2026-11-24. The raw local research extracts are temporary reference material, not repository deliverables.

Production product API is Dypnsapi, version 2017-05-25. Provider transport must verify the official signing contract and use exact action/response envelopes below.

| Action | Request facts | Success extraction | Official source |
| --- | --- | --- | --- |
| GetAuthToken | Configured Origin and Url, SceneCode required despite optional table marker, BizType=1 for one-click | Code OK; TokenInfo.AccessToken and TokenInfo.JwtToken | https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-getauthtoken |
| GetPhoneWithToken | SpToken from H5 SDK | Code OK; Data.Mobile | https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-getphonewithtoken |
| GetMobile | AccessToken from App SDK; optional OutId | Code OK; GetMobileResultDTO.Mobile | https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-getmobile |
| SendSmsVerifyCode | PhoneNumber, CountryCode=86, SignName, TemplateCode, TemplateParam with provider code placeholder, SchemeName for purpose isolation, CodeType=1, CodeLength=6, ValidTime=300, DuplicatePolicy=1, Interval=60, ReturnVerifyCode=false | Code OK and successful result; never expose Model.VerifyCode even if present | https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode |
| CheckSmsVerifyCode | Same SchemeName/CountryCode/PhoneNumber as send; VerifyCode; optional OutId for correlation | Code OK is insufficient: Model.VerifyResult must be PASS | https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode |

H5 integration: https://help.aliyun.com/zh/pnvs/developer-reference/h5-client-access . Instantiate PhoneNumberServer from the console-provided SDK. Call checkLoginAvailable with server-issued accessToken/jwtToken, then getLoginToken, then exchange returned spToken on the gateway. Preserve the provider authorization page and its consent controls. Current documented H5 flow requires mobile data and completion of the middle four digits; fallback must remain usable.

The similarly named h5-client-access-1 page describes number verification, using checkAuthAvailable/getVerifyToken/VerifyPhoneWithToken. Do not mix it with the one-click sequence.

App callers integrate the approved native SDK and send its login token to the gateway. The gateway's AccessKey secret is never embedded in an App or browser. Existing expired/masked/partial provider phone values fail canonical mainland-phone validation. No real provider account, paid send or live SIM test is available in this task.
