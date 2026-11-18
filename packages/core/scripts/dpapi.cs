using System;
using System.Security.Cryptography;

internal static class Dpapi {
    static int Main(string[] args) {
        if (args.Length != 1) return 1;
        try {
            byte[] input = Convert.FromBase64String(Console.In.ReadToEnd());
            byte[] output;
            if (args[0] == "Protect" && input.Length == 32)
                output = ProtectedData.Protect(input, null, DataProtectionScope.CurrentUser);
            else if (args[0] == "Unprotect")
                output = ProtectedData.Unprotect(input, null, DataProtectionScope.CurrentUser);
            else return 1;
            Console.Write(Convert.ToBase64String(output));
            return 0;
        } catch (Exception) { return 1; }
    }
}
